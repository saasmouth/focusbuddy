import { test, expect } from '@playwright/test'
import { launchApp, waitForReady } from './_helpers'

// Verifies the new Agentic Ops tile (segments.tsx + AgenticOpsView.tsx):
// 1. The PlexiDesk shell tile grid shows "Agentic Ops" alongside Plans.
// 2. Opening it renders the embedded ops console webview (the local dashboard
//    at localhost:8765 is live), with the real console content loaded in the
//    guest, not a blank pane and not the offline state.
// 3. Neighbouring Plans tile still opens PlexiProjectsView (no regression).
//
// Read-only against the live dashboard service: the guest page is inspected
// with getURL/getTitle/innerText only. No writes, no service restarts.

test('Agentic Ops tile renders embedded console; Plans unaffected', async () => {
  test.setTimeout(120_000)
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await expect(window.locator('text=Something went wrong')).toHaveCount(0)

    // Enter the PlexiDesk segment shell (tiles home).
    await window.evaluate(() => {
      const w = window as unknown as {
        __fbView?: { getState: () => { goPlexiDesk: (app?: string) => void } }
      }
      w.__fbView?.getState().goPlexiDesk()
    })

    // 1. Tile grid shows Agentic Ops next to Plans.
    const opsTile = window.locator('[data-testid="segment-tile-ops"]')
    const plansTile = window.locator('[data-testid="segment-tile-plans"]')
    await expect(opsTile).toBeVisible({ timeout: 10_000 })
    await expect(plansTile).toBeVisible()
    await expect(opsTile).toContainText('Agentic Ops')
    console.log('[agentic-ops] tile grid shows Agentic Ops alongside Plans')

    // 2. Open it. The probe should find the live dashboard and mount the webview.
    await opsTile.click()
    const wv = window.locator('webview[partition="persist:agentic-ops"]')
    await expect(wv).toBeVisible({ timeout: 15_000 })
    // The offline state must NOT be shown while the service is live.
    await expect(window.locator('text=Ops console not reachable')).toHaveCount(0)

    // Prove the guest actually loaded the real console (not a blank pane):
    // poll the webview element until the guest reports a loaded page, then
    // read its title and visible text. Read-only inspection.
    await window.waitForFunction(
      () => {
        const el = document.querySelector(
          'webview[partition="persist:agentic-ops"]'
        ) as unknown as { getURL?: () => string; isLoading?: () => boolean } | null
        if (!el || typeof el.getURL !== 'function') return false
        try {
          const url = el.getURL()
          const loading = typeof el.isLoading === 'function' ? el.isLoading() : false
          return url.startsWith('http://localhost:8765') && !loading
        } catch {
          return false
        }
      },
      null,
      { timeout: 20_000 }
    )
    // The console is an SPA: give it a moment to paint its main content after
    // the load event, polling the guest's visible text until it carries the
    // real console UI (triage queue / board / project content), then assert.
    let guest = { url: '', title: '', text: '' }
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      guest = await window.evaluate(async () => {
        const el = document.querySelector(
          'webview[partition="persist:agentic-ops"]'
        ) as unknown as {
          getURL: () => string
          getTitle: () => string
          executeJavaScript: (code: string) => Promise<string>
        }
        const text = await el.executeJavaScript(
          'document.body ? document.body.innerText.slice(0, 8000) : ""'
        )
        return { url: el.getURL(), title: el.getTitle(), text }
      })
      if (guest.text.length > 200 && /triage|board|project|queue/i.test(guest.text)) break
      await window.waitForTimeout(500)
    }
    console.log(`[agentic-ops] guest url=${guest.url} title=${JSON.stringify(guest.title)}`)
    console.log(`[agentic-ops] guest text sample: ${guest.text.slice(0, 400).replace(/\n/g, ' | ')}`)
    expect(guest.url.startsWith('http://localhost:8765')).toBe(true)
    expect(guest.title).toBe('Archeon Projects')
    // The loaded UI must carry real console content, not a blank pane.
    expect(guest.text.length).toBeGreaterThan(200)
    expect(/triage|board|project|queue/i.test(guest.text)).toBe(true)

    // 3. Regression: back to tiles home, Plans still opens PlexiProjectsView.
    await window.locator('[data-testid="nav-plexidesk-home"]').click()
    await expect(plansTile).toBeVisible({ timeout: 10_000 })
    await plansTile.click()
    await expect(window.locator('[data-testid="plexiprojects-view"]')).toBeVisible({
      timeout: 10_000
    })
    await expect(window.locator('text=Something went wrong')).toHaveCount(0)
    console.log('[agentic-ops] Plans tile still opens PlexiProjectsView')
  } finally {
    await dispose()
  }
})
