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

test('CS-2 — the desk floor is the same colour as Home, in light and in dark', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await seedBusyDesk(window)

  // Asserting the RELATIONSHIP, not two hardcoded colours. The desk used to
  // carry its own colour — a warm beige, then #f1f2f4, then a deep purple — so
  // opening a desk changed the colour of the floor under you. It now paints
  // var(--surface-base), the token <main> paints behind Home, which every theme
  // redefines; pinning literals here would have to be rewritten on every
  // palette change and would say nothing about whether the two still match.
  const floorOf = (sel: string): Promise<string> =>
    window.evaluate((s2: string) => {
      let el: Element | null = document.querySelector(s2)
      while (el) {
        const bg = getComputedStyle(el).backgroundColor
        if (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg
        el = el.parentElement
      }
      return 'none'
    }, sel)

  for (const dark of [false, true]) {
    await window.evaluate((d) => document.documentElement.classList.toggle('dark', d), dark)
    await window.waitForTimeout(200)

    const deskFloor = await floorOf('[data-canvas-surface="true"]')

    // Go Home and read the floor the dashboard sits on.
    await window.evaluate(() => {
      const w = window as unknown as { __fbView?: { getState: () => { goHome: () => void } } }
      w.__fbView?.getState().goHome()
    })
    await window.waitForSelector('[data-testid="home-dashboard"]', { timeout: 8000 })
    await window.waitForTimeout(300)
    const homeFloor = await floorOf('[data-testid="home-dashboard"]')

    expect(deskFloor, `desk floor resolved (dark=${dark})`).not.toBe('none')
    expect(deskFloor, `desk matches Home (dark=${dark})`).toBe(homeFloor)

    // And nothing is washed over the desk floor, since Home has no wash.
    const washes = await window.evaluate(() => {
      const surf = document.querySelector<HTMLElement>('[data-canvas-surface="true"]')
      return surf ? getComputedStyle(surf).backgroundImage : ''
    })
    if (washes) {
      expect(washes, `no visible wash over the desk (dark=${dark})`).not.toMatch(
        /rgba\((?!0, 0, 0, 0)/
      )
    }

    // Back to the desk for the next iteration.
    await window.evaluate(() => {
      const w = window as unknown as {
        __fbView?: { getState: () => { goTask: (x: string) => void } }
        __fbNodes?: unknown
      }
      void w
    })
    await seedBusyDesk(window)
  }
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
