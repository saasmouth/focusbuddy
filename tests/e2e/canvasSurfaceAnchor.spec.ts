import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null
test.afterEach(async () => { await launched?.app.close(); launched = null })

/** Seed a desk with enough widgets that the surface has real scroll range. */
async function seedBusyDesk(window: LaunchedApp['window']) {
  const id = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const d = await api.nodes.create({ parentId: null, kind: 'task', title: 'Anchor probe' })
    for (let i = 0; i < 24; i++) {
      await api.widgets.create({
        taskId: d.id, kind: 'sticky', title: `s${i}`, content: '',
        x: (i % 6) * 420, y: Math.floor(i / 6) * 320, width: 280, height: 220
      })
    }
    return d.id
  })
  await window.reload()
  await waitForReady(window)
  await window.evaluate((i) => {
    const w = window as unknown as { __fbView?: { getState: () => { goTask: (x: string) => void } } }
    w.__fbView?.getState().goTask(i)
  }, id)
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8000 })
  await window.waitForTimeout(600)
}

test('CS-1 — the desk surface never keeps a scroll offset, so the chrome stays anchored', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await seedBusyDesk(window)

  await window.evaluate(() => {
    const w = window as unknown as { __fbWidgets?: { getState: () => { setZoom: (n: number) => void } } }
    w.__fbWidgets?.getState().setZoom(2)
  })
  await window.waitForTimeout(500)

  // There has to be scroll range, or this test proves nothing.
  const range = await window.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-canvas-surface="true"]')!
    return { overflowX: el.scrollWidth - el.clientWidth, overflowY: el.scrollHeight - el.clientHeight }
  })
  expect(range.overflowX).toBeGreaterThan(200)

  // Scroll it the way element.focus() / scrollIntoView would.
  const after = await window.evaluate(async () => {
    const el = document.querySelector<HTMLElement>('[data-canvas-surface="true"]')!
    el.scrollLeft = 1062
    el.scrollTop = 254
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const surf = el.getBoundingClientRect()
    const fab = document.querySelector<HTMLElement>('[data-minimap-fab]')!.getBoundingClientRect()
    return {
      scrollLeft: Math.round(el.scrollLeft),
      scrollTop: Math.round(el.scrollTop),
      gapRight: Math.round(surf.right - fab.right),
      gapBottom: Math.round(surf.bottom - fab.bottom),
      // Where the minimap is MEANT to sit: beside the Plexii pill while the
      // pill shows (it publishes this), in the corner (12px) when it does not.
      anchorRight:
        parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fb-pill-clear-right')) || 12
    }
  })

  expect(after.scrollLeft).toBe(0)
  expect(after.scrollTop).toBe(0)
  // Anchored where it is meant to be, not carried off by a scroll offset (the
  // scroll above was 1062px). bottom-3 is 12px; on the right the minimap sits
  // beside the Plexii pill while it shows (76px — 2026-10-10, it used to sit
  // under it), else in the corner. Allow for a scrollbar gutter either way.
  expect(after.gapRight).toBeGreaterThanOrEqual(after.anchorRight - 2)
  expect(after.gapRight).toBeLessThan(after.anchorRight + 36)
  expect(after.gapBottom).toBeLessThan(48)
})

test('CS-2 — the canvas is light grey in light mode and deep purple in dark', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await seedBusyDesk(window)

  const read = async (dark: boolean) => {
    await window.evaluate((d) => {
      document.documentElement.classList.toggle('dark', d)
    }, dark)
    await window.waitForTimeout(150)
    return window.evaluate(() => {
      const cs = getComputedStyle(document.querySelector<HTMLElement>('[data-canvas-surface="true"]')!)
      const layer = document.querySelector<HTMLElement>('.desk-pattern-layer')
      return {
        bg: cs.backgroundColor,
        dots: layer ? getComputedStyle(layer).backgroundImage : ''
      }
    })
  }

  const light = await read(false)
  expect(light.bg).toBe('rgb(241, 242, 244)') // #f1f2f4 — grey, not beige #fbf7ee
  expect(light.dots).toContain('rgba(90, 98, 112')

  const dark = await read(true)
  expect(dark.bg).toBe('rgb(34, 0, 64)') // #220040 — deep saturated purple
  expect(dark.dots).toContain('rgba(167, 139, 250') // lighter violet dots
})

test('CS-3 — no time-of-day glow paints over the canvas, in either theme', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await seedBusyDesk(window)

  // The amber glow was a ::before on the desk surface, painted at --tod-hue
  // (default 45 = amber) and centred above the top edge. Assert the overlay
  // paints nothing at all rather than checking for a particular hue — a glow
  // in any colour over the canvas is the thing that was unwanted.
  for (const dark of [false, true]) {
    await window.evaluate((d) => {
      document.documentElement.classList.toggle('dark', d)
    }, dark)
    await window.waitForTimeout(150)
    const overlay = await window.evaluate(() => {
      const surf = document.querySelector<HTMLElement>('[data-canvas-surface="true"]')!
      const cs = getComputedStyle(surf, '::before')
      return { content: cs.content, backgroundImage: cs.backgroundImage }
    })
    expect(overlay.backgroundImage).toBe('none')
    expect(overlay.content).toBe('none')
  }
})
