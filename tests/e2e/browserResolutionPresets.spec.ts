import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// Feature 2 — Browser-widget resolution presets:
//   • A button (aria-label="Resize to a stored resolution") appears to the right of the URL bar
//   • Opening it shows 4 presets: Mobile 390×844, Tablet 768×1024, Laptop 1366×768, Desktop 1920×1080
//   • Clicking a preset calls update(widget.id, { width, height }) and closes the menu
//   • Currently-matching size shows a check icon
//   • There is a click-away backdrop
//   • The existing back/forward/reload/URL-bar toolbar is not broken
//
// The right-side task-list sidebar can overlap widget toolbars at the default layout, so we
// use the DOM .click() approach (same as widgetResize.spec.ts) to bypass
// Playwright's pointer-event interception checks.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function seedBrowserWidget(
  l: LaunchedApp
): Promise<{ taskId: string; widgetId: string }> {
  const { window } = l

  await waitForReady(window)
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  const skip = window.getByRole('button', { name: /Continue without account|Skip|Not now/i })
  if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {})

  const seeded = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({
      parentId: null,
      kind: 'task',
      title: 'Browser Preset test'
    })
    // Start with a size that doesn't match any preset (560×400)
    const w = await api.widgets.create({
      taskId: task.id,
      kind: 'webview',
      title: 'test browser',
      content: 'https://example.com',
      x: 100,
      y: 100,
      width: 560,
      height: 400
    })
    return { taskId: task.id, widgetId: w.id }
  })

  await window.reload()
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  const skip2 = window.getByRole('button', { name: /Continue without account|Skip|Not now/i })
  if (await skip2.isVisible().catch(() => false)) await skip2.click().catch(() => {})

  await window.getByRole('button', { name: 'Browser Preset test' }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })

  return seeded
}

// Direct DOM click — bypasses pointer-event interception (sidebar overlay) just
// as widgetResize.spec.ts does for its header buttons.
async function domClick(l: LaunchedApp, selector: string): Promise<void> {
  await l.window.evaluate((sel: string) => {
    const el = document.querySelector<HTMLElement>(sel)
    if (!el) throw new Error(`domClick: element not found: ${sel}`)
    el.click()
  }, selector)
}

test('browser widget toolbar has back, forward, reload and URL bar (existing toolbar not broken)', async () => {
  launched = await launchApp()
  const { widgetId } = await seedBrowserWidget(launched)
  const { window } = launched

  await waitForReady(window)
  await window.waitForSelector(`[data-widget-id="${widgetId}"]`, { timeout: 5_000 })

  const widgetRoot = window.locator(`[data-widget-id="${widgetId}"]`)

  // Back button
  await expect(widgetRoot.getByRole('button', { name: /go back/i })).toBeVisible({ timeout: 5_000 })
  // Forward button
  await expect(widgetRoot.getByRole('button', { name: /go forward/i })).toBeVisible({ timeout: 5_000 })
  // Reload/Stop button
  await expect(
    widgetRoot.getByRole('button', { name: /^(reload|stop loading)$/i })
  ).toBeVisible({ timeout: 5_000 })
  // URL bar input
  await expect(
    widgetRoot.locator('input[placeholder="https://…"]')
  ).toBeVisible({ timeout: 5_000 })
})

test('aspect_ratio button is present in the browser widget toolbar', async () => {
  launched = await launchApp()
  const { widgetId } = await seedBrowserWidget(launched)
  const { window } = launched

  await waitForReady(window)
  await window.waitForSelector(`[data-widget-id="${widgetId}"]`, { timeout: 5_000 })

  // Verify the resolution-preset button exists in the DOM (visibility check)
  const exists = await window.evaluate((wid: string) => {
    const widgetEl = document.querySelector(`[data-widget-id="${wid}"]`)
    if (!widgetEl) return false
    const btn = widgetEl.querySelector<HTMLButtonElement>(
      'button[aria-label="Resize to a stored resolution"]'
    )
    return btn !== null
  }, widgetId)

  expect(exists).toBe(true)
})

test('opening the preset menu shows 5 resolution options incl. Tablet landscape', async () => {
  launched = await launchApp()
  const { widgetId } = await seedBrowserWidget(launched)
  const { window } = launched

  await waitForReady(window)
  await window.waitForSelector(`[data-widget-id="${widgetId}"]`, { timeout: 5_000 })

  // Click the resolution preset button via direct DOM click
  await domClick(launched, `[data-widget-id="${widgetId}"] button[aria-label="Resize to a stored resolution"]`)
  await window.waitForTimeout(200)

  // The dropdown should appear — verify all 5 presets are present. We match on
  // the dimension sub-labels so "Tablet" and "Tablet (landscape)" don't collide.
  const presets = await window.evaluate(() => {
    const text = Array.from(document.querySelectorAll('.z-50 button'))
      .map((b) => b.textContent ?? '')
      .join(' | ')
    return {
      hasMobile: text.includes('390 × 844'),
      hasTabletPortrait: text.includes('768 × 1024'),
      hasTabletLandscape: text.includes('1024 × 768'),
      hasLaptop: text.includes('1366 × 768'),
      hasDesktop: text.includes('1920 × 1080')
    }
  })

  expect(presets.hasMobile).toBe(true)
  expect(presets.hasTabletPortrait).toBe(true)
  expect(presets.hasTabletLandscape).toBe(true)
  expect(presets.hasLaptop).toBe(true)
  expect(presets.hasDesktop).toBe(true)
})

test('clicking Tablet (landscape) preset resizes the widget to 1024×768', async () => {
  launched = await launchApp()
  const { widgetId, taskId } = await seedBrowserWidget(launched)
  const { window } = launched

  await waitForReady(window)
  await window.waitForSelector(`[data-widget-id="${widgetId}"]`, { timeout: 5_000 })

  await domClick(launched, `[data-widget-id="${widgetId}"] button[aria-label="Resize to a stored resolution"]`)
  await window.waitForTimeout(200)

  const clicked = await window.evaluate(() => {
    const btns = Array.from(document.querySelectorAll<HTMLButtonElement>('.z-50 button'))
    const btn = btns.find((b) => (b.textContent ?? '').includes('1024 × 768'))
    if (!btn) return false
    btn.click()
    return true
  })
  expect(clicked).toBe(true)
  await window.waitForTimeout(400)

  const dims = await window.evaluate(
    async ({ id, tid }: { id: string; tid: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const widgets = await api.widgets.listByTask(tid)
      const w = widgets.find((x) => x.id === id)
      return w ? { width: w.width, height: w.height } : null
    },
    { id: widgetId, tid: taskId }
  )

  expect(dims).not.toBeNull()
  expect(dims!.width).toBe(1024)
  expect(dims!.height).toBe(768)
})

test('preset resize takes effect LIVE on the element (no hard refresh needed)', async () => {
  launched = await launchApp()
  const { widgetId } = await seedBrowserWidget(launched)
  const { window } = launched

  await waitForReady(window)
  const frameSel = `[data-widget-id="${widgetId}"]`
  await window.waitForSelector(frameSel, { timeout: 5_000 })

  // Measure the widget frame's live width BEFORE applying a preset.
  const before = await window.evaluate((sel: string) => {
    const el = document.querySelector(sel) as HTMLElement | null
    return el ? el.getBoundingClientRect().width : null
  }, frameSel)
  expect(before).not.toBeNull()

  // Apply the Mobile preset (390 wide) — a clearly different width.
  await domClick(launched, `${frameSel} button[aria-label="Resize to a stored resolution"]`)
  await window.waitForTimeout(150)
  await window.evaluate(() => {
    const btn = Array.from(document.querySelectorAll<HTMLButtonElement>('.z-50 button')).find(
      (b) => (b.textContent ?? '').includes('390 × 844')
    )
    btn?.click()
  })
  // No reload — just give React + the imperative Rnd resize a beat.
  await window.waitForTimeout(400)

  const after = await window.evaluate((sel: string) => {
    const el = document.querySelector(sel) as HTMLElement | null
    return el ? el.getBoundingClientRect().width : null
  }, frameSel)
  expect(after).not.toBeNull()
  // The element itself must have resized in place — without the useLayoutEffect
  // size-sync it stayed at the mount width until a remount/refresh. Tolerant of
  // the frame's border so we're testing "did it resize live", not exact px.
  expect(after!).toBeGreaterThan(370)
  expect(after!).toBeLessThan(412)
  expect(after!).toBeLessThan(before! - 40)
})

test('clicking Mobile preset resizes the widget to 390×844', async () => {
  launched = await launchApp()
  const { widgetId, taskId } = await seedBrowserWidget(launched)
  const { window } = launched

  await waitForReady(window)
  await window.waitForSelector(`[data-widget-id="${widgetId}"]`, { timeout: 5_000 })

  // Open the preset menu
  await domClick(launched, `[data-widget-id="${widgetId}"] button[aria-label="Resize to a stored resolution"]`)
  await window.waitForTimeout(200)

  // Click the Mobile preset button via DOM — find it inside the dropdown (z-50 container)
  const clicked = await window.evaluate(() => {
    // Find buttons in the preset dropdown (class includes z-50)
    const btns = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    const mobileBtn = btns.find((b) => {
      const inDropdown = !!b.closest('.z-50')
      const isMobile = b.textContent?.toLowerCase().includes('mobile') ?? false
      return inDropdown && isMobile
    })
    if (!mobileBtn) return false
    mobileBtn.click()
    return true
  })
  expect(clicked).toBe(true)
  await window.waitForTimeout(400)

  // Read back dimensions from DB
  const dims = await window.evaluate(
    async ({ id, tid }: { id: string; tid: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const widgets = await api.widgets.listByTask(tid)
      const w = widgets.find((x) => x.id === id)
      return w ? { width: w.width, height: w.height } : null
    },
    { id: widgetId, tid: taskId }
  )

  expect(dims).not.toBeNull()
  expect(dims!.width).toBe(390)
  expect(dims!.height).toBe(844)
})

test('clicking Tablet preset resizes the widget to 768×1024', async () => {
  launched = await launchApp()
  const { widgetId, taskId } = await seedBrowserWidget(launched)
  const { window } = launched

  await waitForReady(window)
  await window.waitForSelector(`[data-widget-id="${widgetId}"]`, { timeout: 5_000 })

  await domClick(launched, `[data-widget-id="${widgetId}"] button[aria-label="Resize to a stored resolution"]`)
  await window.waitForTimeout(200)

  const clicked = await window.evaluate(() => {
    const btns = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    const btn = btns.find((b) => {
      return !!b.closest('.z-50') && (b.textContent?.toLowerCase().includes('tablet') ?? false)
    })
    if (!btn) return false
    btn.click()
    return true
  })
  expect(clicked).toBe(true)
  await window.waitForTimeout(400)

  const dims = await window.evaluate(
    async ({ id, tid }: { id: string; tid: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const widgets = await api.widgets.listByTask(tid)
      const w = widgets.find((x) => x.id === id)
      return w ? { width: w.width, height: w.height } : null
    },
    { id: widgetId, tid: taskId }
  )
  expect(dims).not.toBeNull()
  expect(dims!.width).toBe(768)
  expect(dims!.height).toBe(1024)
})

test('clicking Laptop preset resizes the widget to 1366×768', async () => {
  launched = await launchApp()
  const { widgetId, taskId } = await seedBrowserWidget(launched)
  const { window } = launched

  await waitForReady(window)
  await window.waitForSelector(`[data-widget-id="${widgetId}"]`, { timeout: 5_000 })

  await domClick(launched, `[data-widget-id="${widgetId}"] button[aria-label="Resize to a stored resolution"]`)
  await window.waitForTimeout(200)

  const clicked = await window.evaluate(() => {
    const btns = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    const btn = btns.find((b) => {
      return !!b.closest('.z-50') && (b.textContent?.toLowerCase().includes('laptop') ?? false)
    })
    if (!btn) return false
    btn.click()
    return true
  })
  expect(clicked).toBe(true)
  await window.waitForTimeout(400)

  const dims = await window.evaluate(
    async ({ id, tid }: { id: string; tid: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const widgets = await api.widgets.listByTask(tid)
      const w = widgets.find((x) => x.id === id)
      return w ? { width: w.width, height: w.height } : null
    },
    { id: widgetId, tid: taskId }
  )
  expect(dims).not.toBeNull()
  expect(dims!.width).toBe(1366)
  expect(dims!.height).toBe(768)
})

test('clicking Desktop preset resizes the widget to 1920×1080', async () => {
  launched = await launchApp()
  const { widgetId, taskId } = await seedBrowserWidget(launched)
  const { window } = launched

  await waitForReady(window)
  await window.waitForSelector(`[data-widget-id="${widgetId}"]`, { timeout: 5_000 })

  await domClick(launched, `[data-widget-id="${widgetId}"] button[aria-label="Resize to a stored resolution"]`)
  await window.waitForTimeout(200)

  const clicked = await window.evaluate(() => {
    const btns = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    const btn = btns.find((b) => {
      return !!b.closest('.z-50') && (b.textContent?.toLowerCase().includes('desktop') ?? false)
    })
    if (!btn) return false
    btn.click()
    return true
  })
  expect(clicked).toBe(true)
  await window.waitForTimeout(400)

  const dims = await window.evaluate(
    async ({ id, tid }: { id: string; tid: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const widgets = await api.widgets.listByTask(tid)
      const w = widgets.find((x) => x.id === id)
      return w ? { width: w.width, height: w.height } : null
    },
    { id: widgetId, tid: taskId }
  )
  expect(dims).not.toBeNull()
  expect(dims!.width).toBe(1920)
  expect(dims!.height).toBe(1080)
})

test('clicking a preset closes the dropdown menu', async () => {
  launched = await launchApp()
  const { widgetId } = await seedBrowserWidget(launched)
  const { window } = launched

  await waitForReady(window)
  await window.waitForSelector(`[data-widget-id="${widgetId}"]`, { timeout: 5_000 })

  // Open
  await domClick(launched, `[data-widget-id="${widgetId}"] button[aria-label="Resize to a stored resolution"]`)
  await window.waitForTimeout(150)

  // Confirm open: Tablet button is in the z-50 dropdown
  const openBefore = await window.evaluate(() => {
    const btns = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    return btns.some(
      (b) => !!b.closest('.z-50') && (b.textContent?.toLowerCase().includes('tablet') ?? false)
    )
  })
  expect(openBefore).toBe(true)

  // Click Tablet preset to close
  await window.evaluate(() => {
    const btns = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    const btn = btns.find(
      (b) => !!b.closest('.z-50') && (b.textContent?.toLowerCase().includes('tablet') ?? false)
    )
    btn?.click()
  })
  await window.waitForTimeout(200)

  // Menu should be closed — no more z-50 dropdown buttons with Mobile label
  const openAfter = await window.evaluate(() => {
    const btns = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    return btns.some(
      (b) => !!b.closest('.z-50') && (b.textContent?.toLowerCase().includes('mobile') ?? false)
    )
  })
  expect(openAfter).toBe(false)
})

test('currently matching preset size shows a check mark in the dropdown', async () => {
  launched = await launchApp()
  const { widgetId, taskId } = await seedBrowserWidget(launched)
  const { window } = launched

  await waitForReady(window)
  await window.waitForSelector(`[data-widget-id="${widgetId}"]`, { timeout: 5_000 })

  // Apply Laptop preset (1366×768)
  await domClick(launched, `[data-widget-id="${widgetId}"] button[aria-label="Resize to a stored resolution"]`)
  await window.waitForTimeout(200)
  await window.evaluate(() => {
    const btns = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    const btn = btns.find(
      (b) => !!b.closest('.z-50') && (b.textContent?.toLowerCase().includes('laptop') ?? false)
    )
    btn?.click()
  })
  await window.waitForTimeout(400)

  // Verify DB shows 1366×768
  const dims = await window.evaluate(
    async ({ id, tid }: { id: string; tid: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const widgets = await api.widgets.listByTask(tid)
      const w = widgets.find((x) => x.id === id)
      return w ? { width: w.width, height: w.height } : null
    },
    { id: widgetId, tid: taskId }
  )
  expect(dims).not.toBeNull()
  expect(dims!.width).toBe(1366)
  expect(dims!.height).toBe(768)

  // Now re-open the menu and check for active state on Laptop
  await domClick(launched, `[data-widget-id="${widgetId}"] button[aria-label="Resize to a stored resolution"]`)
  await window.waitForTimeout(200)

  const laptopActive = await window.evaluate(() => {
    const btns = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    const laptopBtn = btns.find(
      (b) => !!b.closest('.z-50') && (b.textContent?.toLowerCase().includes('laptop') ?? false)
    )
    if (!laptopBtn) return { found: false, hasCheck: false, hasFontMedium: false }
    // Check icon is a material symbols span containing text "check"
    const spans = Array.from(laptopBtn.querySelectorAll('span'))
    const hasCheck = spans.some((s) => s.textContent?.trim() === 'check')
    const hasFontMedium = laptopBtn.className.includes('font-medium')
    return { found: true, hasCheck, hasFontMedium }
  })

  expect(laptopActive.found).toBe(true)
  // At least one active-state signal must be present
  expect(laptopActive.hasCheck || laptopActive.hasFontMedium).toBe(true)
})

test('click-away backdrop closes the preset menu', async () => {
  launched = await launchApp()
  const { widgetId } = await seedBrowserWidget(launched)
  const { window } = launched

  await waitForReady(window)
  await window.waitForSelector(`[data-widget-id="${widgetId}"]`, { timeout: 5_000 })

  // Open the menu
  await domClick(launched, `[data-widget-id="${widgetId}"] button[aria-label="Resize to a stored resolution"]`)
  await window.waitForTimeout(200)

  // Confirm open
  const openBefore = await window.evaluate(() => {
    const btns = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    return btns.some(
      (b) => !!b.closest('.z-50') && (b.textContent?.toLowerCase().includes('mobile') ?? false)
    )
  })
  expect(openBefore).toBe(true)

  // The click-away backdrop is the fixed inset-0 z-40 div. Click it directly.
  const backdropClicked = await window.evaluate(() => {
    // Find the backdrop — fixed, inset-0, z-40 — it lives as a sibling of the
    // dropdown inside the relative container. Find it by class pattern.
    const backdrop = document.querySelector<HTMLElement>('.fixed.inset-0.z-40')
    if (!backdrop) return false
    backdrop.click()
    return true
  })
  expect(backdropClicked).toBe(true)
  await window.waitForTimeout(200)

  // Menu should now be closed
  const openAfter = await window.evaluate(() => {
    const btns = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    return btns.some(
      (b) => !!b.closest('.z-50') && (b.textContent?.toLowerCase().includes('mobile') ?? false)
    )
  })
  expect(openAfter).toBe(false)
})
