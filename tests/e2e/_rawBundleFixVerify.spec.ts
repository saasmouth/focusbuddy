import { test, expect } from '@playwright/test'
import { mkdtempSync, rmSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { launchApp, waitForReady } from './_helpers'

// Derive the current build's main renderer chunk at runtime instead of
// hardcoding a hash — the filename changes on every build.
function currentIndexAssetPath(): string {
  const assetsDir = join(process.cwd(), 'out', 'renderer', 'assets')
  const match = readdirSync(assetsDir).find((f) => /^index-.*\.js$/.test(f))
  if (!match) throw new Error(`No index-*.js chunk found in ${assetsDir} — run npm run build first.`)
  return `assets/${match}`
}

// Verifies the 3.8.4 fix for the "raw bundle source rendered as text" bug.
// Plants webview widgets with poisoned (relative/scheme-less) content directly
// via window.api.widgets.create — the same IPC path legacy/corrupted DB rows
// would have gone through, independent of how the content got bad — then boots
// a SECOND instance against the same isolated userData to exercise the
// restore/render path exactly as a real relaunch would. Throwaway — delete
// after triage.

test('fix verify: poisoned webview content never resolves to a file:// or /assets/*.js src', async () => {
  test.setTimeout(60_000)
  // Own the temp dir ourselves — passing it explicitly to launchApp makes each
  // boot's dispose() a no-op on the directory (ownsDir only deletes when the
  // caller did NOT supply a userDataDir), so data survives across the two boots.
  const userDataDir = mkdtempSync(join(tmpdir(), 'plexii-fixverify-'))
  const boot1 = await launchApp({ userDataDir })
  let taskId = ''
  try {
    await waitForReady(boot1.window)
    // Create a task to host the widgets.
    taskId = await boot1.window.evaluate(async () => {
      const w = window as unknown as {
        api: { nodes: { create: (d: unknown) => Promise<{ id: string }> } }
      }
      const node = await w.api.nodes.create({ kind: 'task', title: 'Raw bundle fix verify', parentId: null })
      return node.id
    })
    expect(taskId).toBeTruthy()

    // Plant three webview widgets directly via IPC, bypassing the renderer's
    // own guards, to simulate content that is already bad in the DB (the exact
    // real-world shape: legacy/corrupted rows restored on boot).
    const relativeAssetContent = currentIndexAssetPath()
    console.log('[FIXVERIFY] using current build asset path:', relativeAssetContent)
    const ids = await boot1.window.evaluate(
      async ({ tid, relativeAssetContent }: { tid: string; relativeAssetContent: string }) => {
        const w = window as unknown as {
          api: { widgets: { create: (d: unknown) => Promise<{ id: string }> } }
        }
        const relativeAsset = await w.api.widgets.create({
          taskId: tid,
          kind: 'webview',
          title: 'poisoned-relative-asset',
          content: relativeAssetContent,
          x: 60,
          y: 60,
          width: 400,
          height: 300
        })
        const freeText = await w.api.widgets.create({
          taskId: tid,
          kind: 'webview',
          title: 'poisoned-free-text',
          content:
            '**Origin of the Name Michael****Etymology:** Michael derives from Hebrew (Mikha\'el), meaning "who is like God?"',
          x: 500,
          y: 60,
          width: 400,
          height: 300
        })
        const valid = await w.api.widgets.create({
          taskId: tid,
          kind: 'webview',
          title: 'regression-valid-https',
          content: 'https://example.com',
          x: 940,
          y: 60,
          width: 400,
          height: 300
        })
        return { relativeAsset: relativeAsset.id, freeText: freeText.id, valid: valid.id }
      },
      { tid: taskId, relativeAssetContent }
    )
    console.log('[FIXVERIFY] planted widget ids:', ids)
  } finally {
    await boot1.dispose()
  }

  // Reboot a SECOND instance against the SAME userData dir, so these widgets
  // restore from disk exactly like a real relaunch. Instrument every
  // webContents before the window loads.
  const boot2 = await launchApp({ userDataDir })
  const { app, window, dispose } = boot2
  try {
    await app.evaluate(({ app: electronApp, BrowserWindow }) => {
      const log = (line: string): void => {
        // eslint-disable-next-line no-console
        console.log(line)
      }
      electronApp.on('web-contents-created', (_e, contents) => {
        const type = contents.getType()
        const id = contents.id
        log(`[FIXVERIFY] web-contents-created id=${id} type=${type}`)
        const check = (event: string, url: string): void => {
          const suspicious =
            /\/assets\/.*\.js(\?|#|$)/.test(url) || (/^file:\/\//.test(url) && /\.js(\?|#|$)/.test(url))
          const tag = suspicious ? '[FIXVERIFY][SUSPECT-FAIL]' : '[FIXVERIFY]'
          log(`${tag} id=${id} type=${type} event=${event} url=${url}`)
        }
        contents.on('will-navigate', (_e2, url) => check('will-navigate', url))
        contents.on('did-navigate', (_e2, url) => check('did-navigate', url))
        contents.on('did-fail-load', (_e2, code, desc, url) =>
          log(`[FIXVERIFY] id=${id} type=${type} did-fail-load code=${code} desc=${desc} url=${url}`)
        )
      })
      for (const w of BrowserWindow.getAllWindows()) {
        log(`[FIXVERIFY] existing window url=${w.webContents.getURL()}`)
      }
    })

    await waitForReady(window)

    // Confirm the node store actually has our planted task before navigating —
    // goTask silently no-ops if the id isn't in the in-memory node list yet.
    const nodeCheck = await window.evaluate(async (tid) => {
      const w = window as unknown as {
        api: { nodes: { list: () => Promise<Array<{ id: string }>> } }
      }
      const all = await w.api.nodes.list()
      return { total: all.length, found: all.some((n) => n.id === tid) }
    }, taskId)
    console.log('[FIXVERIFY] node store check via IPC:', JSON.stringify(nodeCheck))

    // Navigate straight to the task hosting the planted widgets. Retry a few
    // times — the renderer's own node store may still be hydrating from IPC.
    for (let i = 0; i < 5; i++) {
      await window.evaluate((tid) => {
        const w = window as unknown as { __fbView?: { getState: () => { goTask: (id: string) => void } } }
        w.__fbView?.getState().goTask(tid)
      }, taskId)
      await window.waitForTimeout(600)
      const anyWidgetFrame = await window.evaluate(() => document.querySelectorAll('[data-widget-id]').length)
      if (anyWidgetFrame > 0) break
    }
    await window.waitForTimeout(1500)

    const debugInfo = await window.evaluate(() => ({
      url: window.location.href,
      bodySample: document.body.innerText.slice(0, 400),
      widgetFrames: document.querySelectorAll('[data-widget-id]').length,
      anyWebview: document.querySelectorAll('webview').length
    }))
    console.log('[FIXVERIFY][DEBUG]', JSON.stringify(debugInfo))

    // Read each webview element's resolved `src` attribute straight out of the
    // DOM — this is the value Electron actually used to navigate.
    const srcs = await window.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll('webview'))
      return nodes.map((n) => ({
        src: n.getAttribute('src'),
        title: n.closest('[data-widget-id]')?.getAttribute('data-widget-id') ?? null
      }))
    })
    console.log('[FIXVERIFY] resolved webview src attributes:', JSON.stringify(srcs, null, 2))

    for (const { src } of srcs) {
      if (src === null || src === '') continue
      expect(src, `webview src resolved to a bundle asset: ${src}`).not.toMatch(/\/assets\/.*\.js(\?|#|$)/)
      expect(src, `webview src resolved to a local file: ${src}`).not.toMatch(/^file:\/\//)
    }

    // The valid https:// widget should still load for real (regression check).
    const validWebview = window.locator('webview[src^="https://example.com"]')
    const validCount = await validWebview.count()
    console.log('[FIXVERIFY] webview[src^=https://example.com] count:', validCount)
    expect(validCount, 'the valid https widget should keep its real src (no regression)').toBeGreaterThan(0)

    const windowsAfter = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((w) => w.webContents.getURL())
    )
    console.log('[FIXVERIFY] top-level windows after render:', windowsAfter)
    for (const url of windowsAfter) {
      expect(url).not.toMatch(/\/assets\/.*\.js(\?|#|$)/)
    }
  } finally {
    await dispose()
    try {
      rmSync(userDataDir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
})
