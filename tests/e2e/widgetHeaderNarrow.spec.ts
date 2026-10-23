import { test, expect, type Page } from '@playwright/test'
import {
  chooseCloudAiSource,
  launchApp,
  type LaunchedApp,
  suppressFeatureSpotlights,
  waitForReady
} from './_helpers'

// The work-widget header at narrow widths, and modifier clicks on its buttons
// (lib/widgetHeaderActions, components/widgets/WidgetHeaderOverflow).
//
// Before: a sticky at its default 240px showed eight header tools that took
// ~200px of the 224px row. The title shrank to nothing and ~16px was left to
// grab the widget by. Now the row folds by priority into "…", keeping a title
// and at least 40px of real, draggable header.
//
// Before: shift-clicking a header button (e.g. "Rewrite with AI") selected the
// widget AND ran the button. Now the modifier wins and the button does nothing.
//
// The header's drag region is react-rnd's (a DOM drag handle), not Electron's
// -webkit-app-region, so Playwright's synthetic input reaches it the way a real
// mouse does; WH-1 asserts that no header control sits in an app drag region.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

interface Seeded {
  taskId: string
  narrow: string
  wide: string
}

async function seedAndOpen(l: LaunchedApp): Promise<Seeded> {
  const { window } = l
  await waitForReady(window)
  await chooseCloudAiSource(window)
  await suppressFeatureSpotlights(window)
  const seeded = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Narrow header desk' })
    const mk = (title: string, x: number, y: number, width: number) =>
      api.widgets.create({
        taskId: task.id,
        kind: 'sticky',
        title,
        // Content, so the AI button reads "Rewrite with AI" (lib/widgetAi).
        content: 'Call the supplier about the delivery window',
        x,
        y,
        width,
        height: 200
      })
    // The sticky's catalogue default width, and a wide one for contrast.
    const narrow = await mk('Supplier follow-up notes', 160, 160, 240)
    const wide = await mk('Wide sticky', 160, 460, 640)
    return { taskId: task.id, narrow: narrow.id, wide: wide.id }
  })
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /Narrow header desk/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
  for (const id of [seeded.narrow, seeded.wide]) {
    await window.waitForSelector(`[data-widget-id="${id}"] [data-widget-header]`, { timeout: 8_000 })
  }
  // Let the desk's entrance animation settle (see stickyWidget.spec.ts).
  await window.evaluate(async (wid: string) => {
    const w = document.querySelector(`[data-widget-id="${wid}"]`)
    const moving = document.getAnimations().filter((a) => {
      const t = (a.effect as KeyframeEffect | null)?.target
      const timing = a.effect?.getComputedTiming()
      return t instanceof Element && w && timing?.iterations !== Infinity && (t.contains(w) || w.contains(t))
    })
    await Promise.all(moving.map((a) => a.finished.catch(() => undefined)))
  }, seeded.narrow)
  return seeded
}

const CONTROL = 'button, input, textarea, select, a, [role="button"], [role="menuitem"], [contenteditable="true"]'

/** Hit-test the header's centre line: which x positions are plain, draggable header. */
async function headerGrabPoints(window: Page, wid: string): Promise<{ xs: number[]; y: number; width: number }> {
  return window.evaluate(
    ({ wid, CONTROL }) => {
      const h = document.querySelector(`[data-widget-id="${wid}"] [data-widget-header]`) as HTMLElement
      const b = h.getBoundingClientRect()
      const y = b.top + b.height / 2
      const xs: number[] = []
      for (let x = Math.ceil(b.left) + 1; x < b.right - 1; x++) {
        const hit = document.elementFromPoint(x, y)
        if (!hit || hit.closest('[data-widget-header]') !== h) continue
        if (hit.closest(CONTROL)) continue
        // .widget-nodrag is react-rnd's `cancel`: the title text is readable but
        // not grabbable, so it does not count as grab area.
        if (hit.closest('.widget-nodrag')) continue
        xs.push(x)
      }
      return { xs, y, width: b.width }
    },
    { wid, CONTROL }
  )
}

async function widgetRow(window: Page, taskId: string, wid: string): Promise<{ x: number; y: number; width: number }> {
  return window.evaluate(
    async ({ tid, wid }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const w = (await api.widgets.listByTask(tid)).find((x) => x.id === wid)!
      return { x: w.x, y: w.y, width: w.width }
    },
    { tid: taskId, wid }
  )
}

async function hoverHeader(window: Page, wid: string): Promise<void> {
  // The tool row fades in on :hover (opacity, 120ms). Re-measure and nudge the
  // pointer on each attempt: the desk can still be settling after it opens,
  // and :hover only updates on a real pointer move.
  let n = 0
  await expect(async () => {
    const box = (await window.locator(`[data-widget-id="${wid}"] [data-widget-header]`).boundingBox())!
    const x = box.x + 20 + (n++ % 3)
    const y = box.y + box.height / 2
    await window.mouse.move(x, y)
    await window.waitForTimeout(200)
    const state = await window.evaluate(
      ({ w, x, y }) => {
        const hit = document.elementFromPoint(x, y)
        return {
          opacity: getComputedStyle(document.querySelector(`[data-widget-id="${w}"] .fb-widget-actions`)!).opacity,
          over: hit?.closest(`[data-widget-id="${w}"]`) ? 'widget' : (hit?.outerHTML.slice(0, 160) ?? 'nothing')
        }
      },
      { w: wid, x, y }
    )
    expect(state).toEqual({ opacity: '1', over: 'widget' })
  }).toPass({ timeout: 10_000 })
}

const ALL_TOOLS = [
  /with AI/,
  /^Rename work widget$/,
  /^Link to another work widget$/,
  /^Pin to screen$/,
  /^Shrink work widget$/,
  /^Grow work widget$/,
  /^Expand options$/,
  /^Remove work widget$/
]

test('WH-1 — a 240px sticky keeps a title and ≥40px of grabbable header; the rest fold into "…" and work', async () => {
  launched = await launchApp()
  const { window } = launched
  const s = await seedAndOpen(launched)
  const header = window.locator(`[data-widget-id="${s.narrow}"] [data-widget-header]`)
  await hoverHeader(window, s.narrow)

  // Grab area: plain header points, measured with elementFromPoint.
  const grab = await headerGrabPoints(window, s.narrow)
  expect(grab.width).toBeGreaterThan(230)
  expect(grab.width).toBeLessThan(250)
  expect(grab.xs.length).toBeGreaterThanOrEqual(40)

  // The title is on screen, with width, and not covered by a control.
  const title = window.locator(`[data-testid="widget-title-${s.narrow}"]`)
  await expect(title).toBeVisible()
  const tb = (await title.boundingBox())!
  expect(tb.width).toBeGreaterThan(20)
  const onTop = await window.evaluate(
    ({ x, y, wid }) => document.elementFromPoint(x, y)?.closest(`[data-testid="widget-title-${wid}"]`) !== null,
    { x: tb.x + Math.min(10, tb.width / 2), y: tb.y + tb.height / 2, wid: s.narrow }
  )
  expect(onTop).toBe(true)
  // A long title truncates with an ellipsis rather than pushing the tools out.
  const titleCss = await title.evaluate((el) => {
    const cs = getComputedStyle(el)
    return { overflow: cs.overflow, textOverflow: cs.textOverflow, clipped: el.scrollWidth > el.clientWidth }
  })
  expect(titleCss.textOverflow).toBe('ellipsis')
  expect(titleCss.clipped).toBe(true)

  // Header tools shown inline: the top priorities, AI first.
  const inline = await header
    .locator('.fb-widget-actions > button')
    .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''))
  expect(inline[0]).toMatch(/^Rewrite with AI/)
  expect(inline).toContain('Expand options')
  expect(inline[inline.length - 1]).toBe('More actions')

  // No header control is in an Electron drag region (those swallow real clicks).
  const regions = await header.evaluate((h) =>
    Array.from(h.querySelectorAll('button')).map((b) => {
      let el: Element | null = b
      while (el) {
        const r = getComputedStyle(el).getPropertyValue('-webkit-app-region')
        if (r === 'drag') return 'drag'
        el = el.parentElement
      }
      return 'none'
    })
  )
  expect(regions.every((r) => r === 'none')).toBe(true)

  // Open "…": it holds the folded tools; together with the inline ones, every tool once.
  const more = window.locator(`[data-testid="widget-overflow-${s.narrow}"]`)
  await expect(more).toHaveAttribute('aria-haspopup', 'menu')
  await window.screenshot({ path: test.info().outputPath('widget-header-240-hover.png') })
  await more.click()
  const menu = window.getByRole('menu', { name: 'More work widget actions' })
  await expect(menu).toBeVisible()
  await expect(more).toHaveAttribute('aria-expanded', 'true')
  // The visible label of each item (its icon glyph is aria-hidden).
  const labels = (await menu.locator('[role="menuitem"] > span.truncate').allInnerTexts()).map((l) => l.trim())
  expect(labels.length).toBeGreaterThan(0)
  for (const tool of ALL_TOOLS) {
    const where = [...inline, ...labels].filter((l) => tool.test(l))
    expect(where, `${tool} reachable exactly once (inline ${JSON.stringify(inline)}, menu ${JSON.stringify(labels)})`).toHaveLength(1)
  }
  await window.screenshot({ path: test.info().outputPath('widget-header-240-overflow-open.png') })

  // A folded tool works: Grow (×1.5) from the menu.
  await menu.getByRole('menuitem', { name: 'Grow work widget' }).click()
  await expect(menu).toBeHidden()
  await expect.poll(async () => (await widgetRow(window, s.taskId, s.narrow)).width).toBe(360)
})

test('WH-2 — dragging by the grab area moves a 240px sticky', async () => {
  launched = await launchApp()
  const { window } = launched
  const s = await seedAndOpen(launched)
  await hoverHeader(window, s.narrow)
  const before = await widgetRow(window, s.taskId, s.narrow)
  const grab = await headerGrabPoints(window, s.narrow)
  // The strip between the title and the tools, at its centre. It is itself at
  // least 40px wide (HEADER_MIN_GRAB_PX), header padding not counted.
  const strip = (await window.locator(`[data-widget-id="${s.narrow}"] [data-testid="widget-grab"]`).boundingBox())!
  expect(strip.width).toBeGreaterThanOrEqual(40)
  const x = Math.round(strip.x + strip.width / 2)
  expect(grab.xs).toContain(x)
  const hit = await window.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.getAttribute('data-testid') ?? null,
    { x, y: grab.y }
  )
  expect(hit).toBe('widget-grab')
  await window.mouse.move(x, grab.y)
  await window.mouse.down()
  for (let i = 1; i <= 10; i++) await window.mouse.move(x + i * 16, grab.y + i * 6)
  await window.mouse.up()
  await expect
    .poll(async () => {
      const after = await widgetRow(window, s.taskId, s.narrow)
      return after.x - before.x
    })
    .toBeGreaterThan(80)
})

test('WH-3 — shift-clicking "Rewrite with AI" selects the work widget and opens nothing; a plain click opens it', async () => {
  launched = await launchApp()
  const { window } = launched
  const s = await seedAndOpen(launched)
  await hoverHeader(window, s.narrow)
  const ai = window.locator(`[data-widget-id="${s.narrow}"] [data-testid="widget-ai"]`)
  await expect(ai).toHaveAttribute('aria-label', /^Rewrite with AI/)
  const b = (await ai.boundingBox())!

  // Real Shift + mouse click on the button itself.
  await window.keyboard.down('Shift')
  await window.mouse.click(b.x + b.width / 2, b.y + b.height / 2)
  await window.keyboard.up('Shift')

  await expect.poll(() => window.evaluate(() => document.body.innerText.includes('1 selected'))).toBe(true)
  // The selection ring is on the frame.
  await expect(window.locator(`[data-widget-id="${s.narrow}"].ring-2`)).toHaveCount(1)
  // Give a wrongly-run action time to show itself.
  await window.waitForTimeout(600)
  await expect(window.locator('[data-testid="widget-setup-preview"]')).toHaveCount(0)

  // Shift-click a FOLDED tool in "…" too: selection toggles off, Remove does not run.
  await window.locator(`[data-testid="widget-overflow-${s.narrow}"]`).click()
  const remove = window.getByRole('menuitem', { name: 'Remove work widget' })
  await expect(remove).toBeVisible()
  const rb = (await remove.boundingBox())!
  await window.keyboard.down('Shift')
  await window.mouse.click(rb.x + rb.width / 2, rb.y + rb.height / 2)
  await window.keyboard.up('Shift')
  await window.waitForTimeout(600)
  await expect(window.locator(`[data-widget-id="${s.narrow}"]`)).toHaveCount(1)
  expect((await widgetRow(window, s.taskId, s.narrow)).width).toBe(240)
  await expect.poll(() => window.evaluate(() => document.body.innerText.includes('1 selected'))).toBe(false)
  await window.keyboard.press('Escape')

  // Plain click still runs the button.
  await hoverHeader(window, s.narrow)
  await ai.click()
  await expect(window.locator('[data-testid="widget-setup-preview"]')).toBeVisible({ timeout: 8_000 })
})

test('WH-4 — a wide sticky shows every tool and no "…"; "…" is keyboard-operable on a narrow one', async () => {
  launched = await launchApp()
  const { window } = launched
  const s = await seedAndOpen(launched)
  await hoverHeader(window, s.wide)
  const wideHeader = window.locator(`[data-widget-id="${s.wide}"] [data-widget-header]`)
  await expect(window.locator(`[data-testid="widget-overflow-${s.wide}"]`)).toHaveCount(0)
  const inline = await wideHeader
    .locator('.fb-widget-actions > button')
    .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''))
  for (const tool of ALL_TOOLS) expect(inline.filter((l) => tool.test(l)), String(tool)).toHaveLength(1)
  await window.screenshot({ path: test.info().outputPath('widget-header-640-hover.png') })

  // Keyboard: focus "…", Enter opens with focus on the first item, arrows move,
  // Escape closes and returns focus to "…".
  const more = window.locator(`[data-testid="widget-overflow-${s.narrow}"]`)
  await more.focus()
  await window.keyboard.press('Enter')
  const items = window.getByRole('menuitem')
  await expect(items.first()).toBeFocused()
  await window.keyboard.press('ArrowDown')
  await expect(items.nth(1)).toBeFocused()
  await window.keyboard.press('Escape')
  await expect(window.getByRole('menu')).toHaveCount(0)
  await expect(more).toBeFocused()
})
