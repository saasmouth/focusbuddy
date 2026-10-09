// Footage of every persona demo desk, for the persona marketing videos
// (marketing/persona-videos). Real screenshots of the real built app: nothing in
// a video frame is mocked.
//
// Throwaway spec (leading underscore). Same throwaway-profile contract as
// _personaDeskShots.spec.ts, and refuses a live profile. Writes, per desk:
//   <OUT>/<persona-slug>/d<n>/full.png         the whole desk, fitted (app's own Home)
//   <OUT>/<persona-slug>/d<n>/<kind>-<i>.png   each widget framed in the video's portrait
//                                              aspect with a margin of desk around it
//   <OUT>/<persona-slug>/d<n>/shots.json       [{ file, kind, title, width, height }]
//   <OUT>/<persona-slug>/d<n>/browsers.json    each browser's live page title + URL, so a
//                                              bot challenge or redirect is caught
//
//   PERSONA_PROFILE=<dir> SHOT_DIR=<dir> [PERSONA_ONLY=slug,slug] \
//     npx playwright test tests/e2e/_personaVideoShots.spec.ts

import { test, type Page } from '@playwright/test'
import { launchApp, waitForReady } from './_helpers'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { homedir } from 'os'

const PROFILE = resolve(process.env.PERSONA_PROFILE ?? '')
const OUT = resolve(process.env.SHOT_DIR ?? 'test-results/persona-video-shots')
const ONLY = (process.env.PERSONA_ONLY ?? '').split(',').filter(Boolean)
const VIEW = { width: 2800, height: 1700 }
// The video's screen card is 1000x1060; every close-up is framed at that aspect.
const ASPECT = 1000 / 1060
// The widget fills this share of the frame; the rest is the desk around it.
const FILL = 0.84
// Close-ups use the app's own canvas zoom, which re-rasterises text and vectors
// at the zoomed size (a true high-res render) and keeps Playwright's coordinates
// in screenshot pixels. Browser widgets stay at zoom 1: their guest page is
// composited, so zooming the canvas would only scale its pixels.
const MAX_ZOOM = 2.2
const LEFT = 320 // clear of the sidebar
const TOP = 70
// eslint-disable-next-line @typescript-eslint/no-require-imports
const lib = require('../../scripts/persona-demos/lib.cjs')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { loadSpecs } = require('../../scripts/persona-demos/seed.cjs')
const KINDS = ['markdown', 'card', 'table', 'chart', 'mindmap', 'page', 'note', 'sticky', 'field', 'webview', 'image', 'diagram', 'custom-block', 'calculator', 'task-link']
const CHALLENGE = /just a moment|attention required|captcha|are you a robot|verify you are|access denied/i

interface Desk {
  id: string
  slug: string
  index: number
}

function desks(): Desk[] {
  const { specs } = loadSpecs([])
  const want = specs.filter((s: any) => !ONLY.length || ONLY.includes(s.slug))
  const db = new DatabaseSync(join(PROFILE, 'focusbuddy.db'), { readOnly: true })
  const out: Desk[] = []
  for (const s of want)
    s.desks.forEach((_: unknown, i: number) => {
      const id = lib.stableId(`desk:${s.slug}:${i}`)
      if (db.prepare('SELECT 1 FROM nodes WHERE id = ? AND trashed_at IS NULL').get(id)) out.push({ id, slug: s.slug, index: i })
    })
  db.close()
  return out
}

// The launch counter climbs with every window the app creates; past three the
// sign-in modal becomes mandatory. Reset it before each boot of the renderer.
function resetSession(): void {
  writeFileSync(join(PROFILE, 'account-session.json'), JSON.stringify({ encryptedToken: null, skippedAt: Date.now(), cachedEmail: null, anonLaunches: 0 }))
}

// Close anything that is not part of the desk: the sign-in prompt, release
// notes, "Later" toasts, the Pre-Task Bridge and desk suggestion chips. All are
// the same dismissals a person would make.
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

test('persona video shots', async () => {
  test.setTimeout(180 * 60_000)
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
      // Sidebar minimised: its upgrade card and connected-apps list are not the desk.
      localStorage.setItem('fb.sidebar.minimized', '1')
    })
    resetSession()
    await window.reload()
    await waitForReady(window)
    await window.setViewportSize(VIEW)
    await calm(window)

    for (const d of list) {
      const dir = join(OUT, d.slug, `d${d.index}`)
      mkdirSync(dir, { recursive: true })
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

      await window.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', ctrlKey: true, bubbles: true })))
      await window.waitForTimeout(800)
      await window
        .waitForFunction(() => [...document.querySelectorAll('webview')].every((w: any) => { try { return !w.isLoading() } catch { return false } }), null, { timeout: 30_000 })
        .catch(() => {})
      // Every widget mounted (off-screen ones mount only after the camera lands),
      // or a whole-desk shot can catch a table with no rows or a missing image.
      await window
        .waitForFunction(() => {
          const s = (window as any).__fbWidgets.getState()
          const live = s.widgets.filter((w: any) => !w.archived && w.kind !== 'minimap')
          return live.every((w: any) => document.querySelector(`[data-widget-id="${CSS.escape(w.id)}"]`))
        }, null, { timeout: 20_000 })
        .catch(() => {})
      await window.waitForTimeout(3000)
      await calm(window)
      const surface = await window.locator('[data-canvas-surface="true"]').boundingBox()
      if (!surface) throw new Error('no canvas surface')
      const clipTo = (r: { x: number; y: number; width: number; height: number }) => {
        const x = Math.max(r.x, 0)
        const y = Math.max(r.y, 0)
        return { x, y, width: Math.min(r.x + r.width, VIEW.width) - x, height: Math.min(r.y + r.height, VIEW.height) - y }
      }
      await window.screenshot({ path: join(dir, 'full.png'), clip: clipTo(surface) })

      // What each browser is actually showing, from main: a challenge or a
      // redirect is visible here even though the host DOM cannot see inside.
      const browsers = await app.evaluate(({ webContents }) =>
        webContents.getAllWebContents().filter((w) => w.getType() === 'webview').map((w) => ({ title: w.getTitle(), url: w.getURL() }))
      )
      writeFileSync(join(dir, 'browsers.json'), JSON.stringify(browsers.map((b) => ({ ...b, challenged: CHALLENGE.test(b.title) })), null, 2))

      const widgets = (await window.evaluate(() =>
        (window as any).__fbWidgets
          .getState()
          .widgets.filter((w: any) => !w.archived)
          .map((w: any) => ({ id: w.id, kind: w.kind, title: w.title, x: w.x, y: w.y, width: w.width, height: w.height }))
      )) as { id: string; kind: string; title: string; x: number; y: number; width: number; height: number }[]
      const shots: { file: string; kind: string; title: string; width: number; height: number }[] = [
        { file: 'full.png', kind: 'full', title: 'Whole desk', width: Math.round(surface.width), height: Math.round(surface.height) }
      ]
      const n: Record<string, number> = {}
      for (const w of widgets.filter((w) => KINDS.includes(w.kind)).sort((a, b) => a.y - b.y || a.x - b.x)) {
        n[w.kind] = (n[w.kind] ?? 0) + 1
        const file = `${w.kind}-${n[w.kind]}.png`
        // Region in world units. A wide widget (a table, a long note) is captured
        // as a landscape strip at high zoom, which the video pans across; anything
        // else, and every browser, is framed in the portrait aspect with desk
        // around it. Either way the frame carries a margin of desk for context.
        // A browser is re-shaped to the video's portrait card for its close-up (in
        // this throwaway copy only): the live page re-flows into it at full
        // sharpness, the way it would if a person resized the widget, instead of
        // a landscape page shrunk into a portrait frame.
        // It is also moved to clear canvas past the desk's right edge: a browser is
        // a separately composited guest page, so a neighbouring browser would draw
        // over the enlarged one whatever the z-index.
        if (w.kind === 'webview') {
          const clearX = Math.max(...widgets.map((o) => o.x + o.width)) + 600
          await window.evaluate(
            ({ id, x }) => (window as any).__fbWidgets.getState().update(id, { x, y: 0, width: 1000, height: 1060 }),
            { id: w.id, x: clearX }
          )
          w.x = clearX
          w.y = 0
          w.width = 1000
          w.height = 1060
          // Moving the widget remounts its browser, which reloads the page: wait for
          // that load, not just for the layout.
          await window.waitForTimeout(800)
          await window
            .waitForFunction(
              (id) => {
                const wv = document.querySelector(`[data-widget-id="${CSS.escape(id)}"] webview`) as any
                try {
                  return !!wv && !wv.isLoading()
                } catch {
                  return false
                }
              },
              w.id,
              { timeout: 30_000 }
            )
            .catch(() => console.log(`SLOW ${d.slug} d${d.index} ${w.title}: browser still loading after 30s`))
          await window.waitForTimeout(1200)
        }
        const wide = w.kind !== 'webview' && w.width / w.height > 1.25
        let rw: number
        let rh: number
        if (wide) {
          rw = w.width * 1.08
          rh = w.height * 1.16
        } else if (w.kind === 'webview') {
          // Already card-shaped: frame the browser itself, edge to edge.
          rw = w.width + 8
          rh = rw / ASPECT
        } else {
          rw = Math.max(w.width / FILL, (w.height * ASPECT) / FILL)
          rh = rw / ASPECT
        }
        const z = w.kind === 'webview' ? 1 : Math.min(MAX_ZOOM, (VIEW.width - LEFT - 40) / rw, (VIEW.height - TOP - 40) / rh)
        // Place the widget, then MEASURE where it actually landed and correct:
        // the canvas world origin is not the surface's left edge, so predicting
        // the screen position from pan alone put every close-up off-centre.
        const want = { x: LEFT + (rw * z) / 2, y: TOP + (rh * z) / 2 }
        const place = (px: number, py: number) =>
          window.evaluate(
            ({ z, px, py }) => {
              const s = (window as any).__fbWidgets.getState()
              s.setZoom(z)
              s.setPan(px, py)
              s.setActive?.(null)
            },
            { z, px, py }
          )
        let px = want.x - (w.x + w.width / 2) * z
        let py = want.y - (w.y + w.height / 2) * z
        await place(px, py)
        await window.waitForTimeout(350)
        const loc = window.locator(`[data-widget-id="${w.id}"]`)
        for (let pass = 0; pass < 3; pass++) {
          const box = await loc.boundingBox()
          if (!box) break
          const dx = want.x - (box.x + box.width / 2)
          const dy = want.y - (box.y + box.height / 2)
          if (Math.abs(dx) < 2 && Math.abs(dy) < 2) break
          px += dx
          py += dy
          await place(px, py)
          await window.waitForTimeout(250)
        }
        await window.waitForTimeout(w.kind === 'webview' ? 3000 : w.kind === 'chart' || w.kind === 'diagram' ? 2400 : 900)
        const box = await loc.boundingBox()
        const cx = box ? box.x + box.width / 2 : want.x
        const cy = box ? box.y + box.height / 2 : want.y
        const clip = clipTo({ x: cx - (rw * z) / 2, y: cy - (rh * z) / 2, width: rw * z, height: rh * z })
        if (clip.width < 40 || clip.height < 40) {
          console.log(`SKIP ${d.slug} d${d.index} ${file}: widget not on screen (${JSON.stringify(box)})`)
          continue
        }
        let ok = false
        for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
          try {
            await window.screenshot({ path: join(dir, file), clip, timeout: 20_000 })
            ok = true
          } catch (e) {
            console.log(`RETRY ${d.slug} d${d.index} ${file}: ${(e as Error).message.split('\n')[0]}`)
            await window.waitForTimeout(1500)
          }
        }
        if (!ok) {
          console.log(`FAILED ${d.slug} d${d.index} ${file}`)
          continue
        }
        shots.push({ file, kind: w.kind, title: w.title, width: Math.round(clip.width), height: Math.round(clip.height) })
      }
      writeFileSync(join(dir, 'shots.json'), JSON.stringify(shots, null, 2))
      console.log(`SHOT ${d.slug} d${d.index}: ${shots.length} shots`)
    }
  } finally {
    await l.dispose()
  }
})
