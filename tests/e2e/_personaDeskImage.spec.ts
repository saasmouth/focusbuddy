// One full-size image of a persona demo desk, for the persona videos.
//
// The whole desk at canvas zoom 1 — real app rendering, sharp text, live browser
// pages — in a single screenshot, with the box of every widget recorded in that
// image's pixels. The videos move a camera over this one image, so the desk
// reads as one continuous place rather than a series of cut-aways, and labels
// can be pinned to exactly the widget being talked about.
//
// Throwaway spec (leading underscore); refuses a live profile. Writes:
//   <OUT>/<slug>/d<n>/desk.png
//   <OUT>/<slug>/d<n>/desk.json   { width, height, title, widgets: [{ ref, kind, title, x, y, w, h }] }
//   <OUT>/<slug>/d<n>/browsers.json
//
//   PERSONA_PROFILE=<dir> SHOT_DIR=<dir> PERSONA_ONLY=<slug> npx playwright test tests/e2e/_personaDeskImage.spec.ts

import { test, type Page } from '@playwright/test'
import { launchApp, waitForReady } from './_helpers'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { execFileSync } from 'child_process'
import { join, resolve } from 'path'
import { homedir } from 'os'

const PROFILE = resolve(process.env.PERSONA_PROFILE ?? '')
const OUT = resolve(process.env.SHOT_DIR ?? 'test-results/persona-desk-images')
const ONLY = (process.env.PERSONA_ONLY ?? '').split(',').filter(Boolean)
const LEFT = 200 // clear of the minimised sidebar rail
const TOP = 170 // clear of the breadcrumb and toolbar
const MARGIN = 40
// Each tile is the part of a 2400x1500 window clear of sidebar, toolbar and tray.
const TILE = { w: 1700, h: 1100 }
const CHALLENGE = /just a moment|attention required|captcha|are you a robot|verify you are|access denied/i
// eslint-disable-next-line @typescript-eslint/no-require-imports
const lib = require('../../scripts/persona-demos/lib.cjs')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { loadSpecs } = require('../../scripts/persona-demos/seed.cjs')

function desks(): { id: string; slug: string; index: number }[] {
  const { specs } = loadSpecs([])
  const db = new DatabaseSync(join(PROFILE, 'focusbuddy.db'), { readOnly: true })
  const out: { id: string; slug: string; index: number }[] = []
  for (const s of specs.filter((s: any) => !ONLY.length || ONLY.includes(s.slug)))
    s.desks.forEach((_: unknown, i: number) => {
      const id = lib.stableId(`desk:${s.slug}:${i}`)
      if (db.prepare('SELECT 1 FROM nodes WHERE id = ? AND trashed_at IS NULL').get(id)) out.push({ id, slug: s.slug, index: i })
    })
  db.close()
  return out
}

function resetSession(): void {
  writeFileSync(join(PROFILE, 'account-session.json'), JSON.stringify({ encryptedToken: null, skippedAt: Date.now(), cachedEmail: null, anonLaunches: 0 }))
}

async function calm(window: Page): Promise<void> {
  for (const sel of ['[data-testid="signin-close"]', '[data-testid="whats-new-close"]', '[data-testid="desk-suggestion-dismiss"]', '[data-testid="feature-spotlight-dismiss"]']) {
    const b = window.locator(sel)
    if (await b.count()) await b.first().click({ timeout: 1500 }).catch(() => {})
  }
  for (const name of ['Later', 'Just open it']) {
    const b = window.getByRole('button', { name })
    if (await b.count()) await b.first().click({ timeout: 1500 }).catch(() => {})
  }
}

test('persona desk images', async () => {
  test.setTimeout(60 * 60_000)
  if (!process.env.PERSONA_PROFILE || PROFILE.startsWith(join(homedir(), 'Library', 'Application Support')))
    throw new Error('PERSONA_PROFILE must be a throwaway copy, never a live profile')
  const list = desks()
  if (!list.length) throw new Error('no persona desks in the profile')

  resetSession()
  const l = await launchApp({ userDataDir: PROFILE, env: { FB_SIGNAL_URL: 'http://127.0.0.1:9', PLEXI_APP: 'preview3' } })
  const { app, window } = l
  try {
    await window.waitForSelector('[data-testid="footer-sync-chip"]', { timeout: 90_000 })
    await waitForReady(window)
    await window.evaluate(() => {
      const p = JSON.parse(localStorage.getItem('fb.onboarding.v2') ?? '{}')
      p.skipped = { ...(p.skipped ?? {}), 'rooms-desks': 999, 'office-connect': 999 }
      localStorage.setItem('fb.onboarding.v2', JSON.stringify(p))
      localStorage.setItem('fb.theme.mode', 'light')
      localStorage.setItem('fb.sidebar.minimized', '1')
      // UI scale 100%: on first run the app picks a screen-fitted scale (0.9 here)
      // as a webContents zoom, which makes CSS pixels and image pixels differ.
      localStorage.setItem('plexi.ui.scale', '1')
    })
    resetSession()
    await window.reload()
    await waitForReady(window)
    await calm(window)


    for (const d of list) {
      const dir = join(OUT, d.slug, `d${d.index}`)
      mkdirSync(dir, { recursive: true })
      await window.setViewportSize({ width: 2400, height: 1500 })
      // CSS pixels (widget rects, clips) must equal image pixels, or the
      // stitched tiles drift by the scale factor at every seam.
      const dpr = await window.evaluate(() => window.devicePixelRatio)
      if (Math.abs(dpr - 1) > 0.001) throw new Error(`devicePixelRatio is ${dpr}, expected 1`)
      await window.evaluate((id) => (window as any).__fbView.getState().goTask(id), d.id)
      await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 15_000 })
      await window.waitForFunction(
        (id) => {
          const s = (window as any).__fbWidgets.getState()
          return s.loadingFor === null && s.layoutHydratedFor === id
        },
        d.id,
        { timeout: 20_000 }
      )
      await window.waitForTimeout(500)
      await calm(window)

      // The desk's extent in world units.
      const ws = (await window.evaluate(() =>
        (window as any).__fbWidgets
          .getState()
          .widgets.filter((w: any) => !w.archived && w.kind !== 'minimap' && !w.pinned)
          .map((w: any) => ({ id: w.id, kind: w.kind, title: w.title, x: w.x, y: w.y, w: w.width, h: w.height }))
      )) as { id: string; kind: string; title: string; x: number; y: number; w: number; h: number }[]
      const minX = Math.min(...ws.map((w) => w.x)) - MARGIN
      const minY = Math.min(...ws.map((w) => w.y)) - MARGIN
      const W = Math.ceil(Math.max(...ws.map((w) => w.x + w.w)) + MARGIN - minX)
      const H = Math.ceil(Math.max(...ws.map((w) => w.y + w.h)) + MARGIN - minY)

      // Tiles at zoom 1 in a normal-size window, stitched afterwards. One giant
      // emulated viewport does not work: the canvas culls and virtualises against
      // the real window, so far-off widgets (pictures, table rows) never paint.
      // Each tile is cropped clear of the app's own chrome.
      const place = (px: number, py: number) =>
        window.evaluate(({ px, py }) => {
          const s = (window as any).__fbWidgets.getState()
          s.setZoom(1)
          s.setPan(px, py)
          s.setActive?.(null)
        }, { px, py })
      // Calibrate screen = pan + world + k once, by measuring a widget.
      const anchor = ws[0]
      await place(LEFT - anchor.x, TOP - anchor.y)
      await window.waitForTimeout(500)
      const ab = await window.locator(`[data-widget-id="${anchor.id}"]`).boundingBox({ timeout: 5000 }).catch(() => null)
      const kx = ab ? ab.x - LEFT : 0
      const ky = ab ? ab.y - TOP : 0
      const tiles: { file: string; x: number; y: number }[] = []
      const boxes = new Map<string, { x: number; y: number; w: number; h: number }>()
      for (let ty = 0; ty * TILE.h < H; ty++)
        for (let tx = 0; tx * TILE.w < W; tx++) {
          const ox = tx * TILE.w
          const oy = ty * TILE.h
          await place(LEFT - kx - (minX + ox), TOP - ky - (minY + oy))
          await window.waitForTimeout(700)
          await window
            .waitForFunction(() => [...document.querySelectorAll('webview')].every((w: any) => { try { return !w.isLoading() } catch { return false } }), null, { timeout: 40_000 })
            .catch(() => console.log(`SLOW ${d.slug} d${d.index}: a browser was still loading`))
          await window.waitForTimeout(2400) // charts animate in
          await calm(window)
          const cw = Math.min(TILE.w, W - ox)
          const ch = Math.min(TILE.h, H - oy)
          // Measure where the world actually is on screen in this tile (the canvas
          // may nudge a requested pan), from any mounted widget, and crop the
          // tile's world rectangle exactly there. Trusting the requested pan
          // produced doubled strips at the seams.
          const measure = async () =>
            (await window.evaluate((ids: string[]) =>
              ids.map((id) => {
                const el = document.querySelector(`[data-widget-id="${CSS.escape(id)}"]`)
                if (!el) return null
                const r = el.getBoundingClientRect()
                return { x: r.x, y: r.y, width: r.width, height: r.height }
              }), ws.map((w) => w.id))) as ({ x: number; y: number; width: number; height: number } | null)[]
          // Where the world landed, and a correction if the canvas put it
          // somewhere other than asked (it occasionally nudges a pan): move by the
          // error, re-measure, until the tile sits at (LEFT, TOP).
          let rects = await measure()
          let ref = ws.findIndex((_, i) => rects[i])
          if (ref < 0) throw new Error(`no widget mounted in tile ${tx},${ty} of ${d.slug} d${d.index}`)
          let offX = rects[ref]!.x - ws[ref].x
          let offY = rects[ref]!.y - ws[ref].y
          for (let fix = 0; fix < 3; fix++) {
            const ex = LEFT - (minX + ox + offX)
            const ey = TOP - (minY + oy + offY)
            if (Math.abs(ex) < 1 && Math.abs(ey) < 1) break
            const st = (await window.evaluate(() => { const s = (window as any).__fbWidgets.getState(); return [s.panX, s.panY] })) as number[]
            await place(st[0] + ex, st[1] + ey)
            await window.waitForTimeout(900)
            rects = await measure()
            ref = ws.findIndex((_, i) => rects[i])
            if (ref < 0) break
            offX = rects[ref]!.x - ws[ref].x
            offY = rects[ref]!.y - ws[ref].y
          }
          if (process.env.DEBUG_TILES) {
            const all = ws.map((w, i) => (rects[i] ? `${w.kind}:${Math.round(rects[i]!.x - w.x)},${Math.round(rects[i]!.y - w.y)}` : null)).filter(Boolean)
            const vp = await window.evaluate(() => [window.innerWidth, window.innerHeight, window.devicePixelRatio, (window as any).__fbWidgets.getState().panX, (window as any).__fbWidgets.getState().panY, (window as any).__fbWidgets.getState().zoom])
            console.log(`DEBUG tile ${tx},${ty} vp=${JSON.stringify(vp)} off=${Math.round(offX)},${Math.round(offY)} all=${all.slice(0, 8).join(' ')}`)
          }
          const clipX = minX + ox + offX
          const clipY = minY + oy + offY
          if (clipX < LEFT - 40 || clipY < TOP - 60 || clipX + cw > 2400 - 60 || clipY + ch > 1500 - 80)
            console.log(`CHROME ${d.slug} d${d.index} tile ${tx},${ty}: crop at ${Math.round(clipX)},${Math.round(clipY)} may touch app chrome`)
          const file = join(dir, `tile-${tx}-${ty}.png`)
          let ok = false
          for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
            try {
              await window.screenshot({ path: file, clip: { x: clipX, y: clipY, width: cw, height: ch }, timeout: 30_000 })
              ok = true
            } catch (e) {
              console.log(`RETRY ${d.slug} d${d.index} tile ${tx},${ty}: ${(e as Error).message.split('\n')[0]}`)
              await window.waitForTimeout(2000)
            }
          }
          if (!ok) throw new Error(`tile ${tx},${ty} of ${d.slug} d${d.index} failed`)
          tiles.push({ file, x: ox, y: oy })
          // A widget's rendered box, in desk pixels, from the tile it sits wholly inside.
          for (const [i, w] of ws.entries()) {
            if (boxes.has(w.id)) continue
            const b = rects[i]
            if (!b) continue
            if (b.x >= clipX && b.y >= clipY && b.x + b.width <= clipX + cw && b.y + b.height <= clipY + ch)
              boxes.set(w.id, { x: Math.round(b.x - offX - minX), y: Math.round(b.y - offY - minY), w: Math.round(b.width), h: Math.round(b.height) })
          }
        }

      // Stitch: a canvas the size of the desk, every tile overlaid at its offset.
      const inputs = tiles.flatMap((t) => ['-i', t.file])
      let chain = `color=c=0xf6f1e7:s=${W}x${H}[c0]`
      tiles.forEach((t, i) => {
        chain += `;[c${i}][${i}:v]overlay=${t.x}:${t.y}[c${i + 1}]`
      })
      execFileSync('ffmpeg', ['-y', '-v', 'error', ...inputs, '-filter_complex', chain, '-map', `[c${tiles.length}]`, '-frames:v', '1', join(dir, 'desk.png')])
      for (const t of tiles) rmSync(t.file)

      // Each widget's box in desk.png pixels, with a ref (<kind>-<n>, in reading
      // order) the video scripts point at. Where no single tile held a widget
      // whole (a tall one), its stored geometry stands in.
      const n: Record<string, number> = {}
      const widgets = []
      for (const w of [...ws].sort((a, b) => a.y - b.y || a.x - b.x)) {
        n[w.kind] = (n[w.kind] ?? 0) + 1
        const b = boxes.get(w.id) ?? { x: Math.round(w.x - minX), y: Math.round(w.y - minY), w: Math.round(w.w), h: Math.round(w.h) }
        widgets.push({ ref: `${w.kind}-${n[w.kind]}`, kind: w.kind, title: w.title, ...b })
      }
      const clip = { width: W, height: H }
      const title = await window.evaluate((id) => (window as any).__fbNodes.getState().nodes.find((x: any) => x.id === id)?.title ?? '', d.id)
      writeFileSync(join(dir, 'desk.json'), JSON.stringify({ width: clip.width, height: clip.height, title, widgets }, null, 2))
      const browsers = await app.evaluate(({ webContents }) =>
        webContents.getAllWebContents().filter((w) => w.getType() === 'webview').map((w) => ({ title: w.getTitle(), url: w.getURL() }))
      )
      writeFileSync(join(dir, 'browsers.json'), JSON.stringify(browsers.map((b) => ({ ...b, challenged: CHALLENGE.test(b.title) })), null, 2))
      console.log(`DESK ${d.slug} d${d.index}: ${clip.width}x${clip.height}, ${widgets.length} widgets`)
    }
  } finally {
    await l.dispose()
  }
})
