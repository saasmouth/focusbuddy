// Render every persona demo desk in the REAL built app and record what it shows.
//
// Throwaway spec (leading underscore). Runs against a seeded COPY of the
// workspace prepared by scripts/persona-demos/{seed.cjs --dry-run,prepare-profile.cjs}
// and refuses a live profile. For each desk it writes:
//   <slug>.png          the whole desk, fitted (the app's own Home — fit all)
//   <slug>--<kind>-<n>.png  each browser / image / diagram / form / calculator / link at zoom 1
//   <slug>.json         a health report: unmounted widgets, error boundaries, empty
//                       setup states, browsers without a page, broken images
// plus _webview-failures.json (guest page load failures, from main).
//
//   PERSONA_PROFILE=<dir> SHOT_DIR=<dir> [PERSONA_ONLY=slug,slug] \
//     npx playwright test tests/e2e/_personaDeskShots.spec.ts

import { test } from '@playwright/test'
import { launchApp, waitForReady } from './_helpers'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, writeFileSync } from 'fs'
import type { Page } from '@playwright/test'
import { join, resolve } from 'path'
import { homedir } from 'os'

const PROFILE = resolve(process.env.PERSONA_PROFILE ?? '')
const OUT = resolve(process.env.SHOT_DIR ?? 'test-results/persona-shots')
const ONLY = (process.env.PERSONA_ONLY ?? '').split(',').filter(Boolean)
const VIEW = { width: 2400, height: 1500 }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const lib = require('../../scripts/persona-demos/lib.cjs')
const ROOT: string = lib.stableId('root')
const DETAIL_KINDS = ['webview', 'image', 'diagram', 'custom-block', 'calculator', 'task-link']

interface Desk {
  id: string
  title: string
  room: string
}

function desks(): Desk[] {
  const db = new DatabaseSync(join(PROFILE, 'focusbuddy.db'), { readOnly: true })
  const rows = db
    .prepare(
      `WITH RECURSIVE t(id) AS (SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN t ON n.parent_id = t.id)
       SELECT n.id, n.title, n.parent_id AS room FROM nodes n JOIN t ON n.id = t.id
       WHERE n.kind = 'task' AND n.trashed_at IS NULL ORDER BY n.parent_id, n.sort_order`
    )
    .all(ROOT) as unknown as Desk[]
  db.close()
  if (!ONLY.length) return rows
  const rooms = new Set(ONLY.map((s) => lib.stableId(`room:${s}`)))
  return rows.filter((d) => rooms.has(d.room))
}

const CHALLENGE = /just a moment|attention required|captcha|are you a robot|verify you are|access denied/i

// The launch counter climbs with every window the app creates; past three the
// sign-in modal becomes mandatory. Reset it before each boot of the renderer.
function resetSession(): void {
  writeFileSync(join(PROFILE, 'account-session.json'), JSON.stringify({ encryptedToken: null, skippedAt: Date.now(), cachedEmail: null, anonLaunches: 0 }))
}

// The same dismissals a person would make: sign-in prompt, release notes,
// toasts, the Pre-Task Bridge, desk suggestion chips.
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

const slugOf = (t: string): string => t.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60)

test('persona desk shots', async () => {
  test.setTimeout(60 * 60_000)
  if (!process.env.PERSONA_PROFILE || PROFILE.startsWith(join(homedir(), 'Library', 'Application Support')))
    throw new Error('PERSONA_PROFILE must be a throwaway copy, never a live profile')
  mkdirSync(OUT, { recursive: true })
  const list = desks()
  if (!list.length) throw new Error('no persona desks in the profile')

  resetSession()
  const l = await launchApp({
    userDataDir: PROFILE,
    // A dead signal port for main, and the preview identity so the dev binary does
    // not re-register plexii:// for the real app.
    env: { FB_SIGNAL_URL: 'http://127.0.0.1:9', PLEXI_APP: 'preview3' }
  })
  const { app, window } = l
  try {
    await app.evaluate(({ app: a }) => {
      const g = globalThis as unknown as { __wvFail: unknown[] }
      g.__wvFail = []
      a.on('web-contents-created', (_e, wc) => {
        if (wc.getType() === 'webview')
          wc.on('did-fail-load', (_x, code, desc, url, isMain) => {
            if (isMain && code !== -3) g.__wvFail.push({ code, desc, url })
          })
      })
    })
    await window.waitForSelector('[data-testid="footer-sync-chip"]', { timeout: 90_000 })
    await waitForReady(window)
    await window.evaluate(() => {
      const p = JSON.parse(localStorage.getItem('fb.onboarding.v2') ?? '{}')
      p.skipped = { ...(p.skipped ?? {}), 'rooms-desks': 999, 'office-connect': 999 }
      localStorage.setItem('fb.onboarding.v2', JSON.stringify(p))
      localStorage.setItem('fb.theme.mode', 'light')
    })
    resetSession()
    await window.reload()
    await waitForReady(window)
    await calm(window)
    await window.setViewportSize(VIEW)

    for (const d of list) {
      const slug = slugOf(d.title)
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
      await window.waitForTimeout(400)
      // Safety net for the Pre-Task Bridge (seeded desks avoid it with importance 3)
      // and anything else that pops over the desk.
      await calm(window)
      // Fit all: the app's own Home binding (a synthetic ctrl+h — Meta+h is the
      // macOS Hide accelerator).
      await window.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', ctrlKey: true, bubbles: true })))
      await window.waitForTimeout(700)
      await window
        .waitForFunction(() => [...document.querySelectorAll('webview')].every((w: any) => { try { return !w.isLoading() } catch { return false } }), null, { timeout: 30_000 })
        .catch(() => {})
      await window.waitForTimeout(1800)
      await calm(window)
      await window.screenshot({ path: join(OUT, `${slug}.png`) })
      // What each browser is actually showing, from main: a bot challenge or a
      // redirect is invisible to the host DOM but plain here.
      const browsers = await app.evaluate(({ webContents }) =>
        webContents.getAllWebContents().filter((w) => w.getType() === 'webview').map((w) => ({ title: w.getTitle(), url: w.getURL() }))
      )

      const report = await window.evaluate(() => {
        const s = (window as any).__fbWidgets.getState()
        const live = s.widgets.filter((w: any) => !w.archived && w.kind !== 'minimap')
        const el = (id: string): Element | null => document.querySelector(`[data-widget-id="${CSS.escape(id)}"]`)
        const t = (id: string): string => el(id)?.textContent ?? ''
        const tag = (w: any): string => `${w.kind}:${w.title}`
        const WEB = ['webview', 'pdf', 'gdoc', 'gsheet', 'gslide', 'email']
        return {
          zoom: s.zoom,
          expected: live.length,
          mounted: document.querySelectorAll('[data-widget-id]').length,
          notMounted: live.filter((w: any) => !el(w.id)).map(tag),
          errorBoundary: live.filter((w: any) => el(w.id)?.querySelector('[data-testid="widget-error"]')).map(tag),
          emptySetup: live.filter((w: any) => /Set up with AI/.test(t(w.id))).map(tag),
          browserNoPage: live.filter((w: any) => WEB.includes(w.kind) && el(w.id) && !el(w.id)!.querySelector('webview')).map(tag),
          brokenImg: [...document.querySelectorAll('[data-widget-id] img')]
            .filter((i: any) => i.complete && i.naturalWidth === 0)
            .map((i) => (i.getAttribute('src') ?? '').slice(0, 60)),
          linkDeleted: live.filter((w: any) => w.kind === 'task-link' && /deleted or moved/.test(t(w.id))).map(tag),
          // The result line renders a red span for an error; text matching misses it
          // because the keypad's 'C' follows 'error' with no word boundary.
          calcError: live.filter((w: any) => w.kind === 'calculator' && el(w.id)?.querySelector('.text-red-700')).map(tag),
          appCrash: /Something went wrong|has no renderer for/.test(document.body.innerText),
          detail: live.filter((w: any) => ['webview', 'image', 'diagram', 'custom-block', 'calculator', 'task-link'].includes(w.kind)).map((w: any) => ({ id: w.id, kind: w.kind, title: w.title }))
        }
      })
      const challenged = browsers.filter((b) => CHALLENGE.test(b.title))
      writeFileSync(join(OUT, `${slug}.json`), JSON.stringify({ ...report, browsers, challenged }, null, 2))

      // Each new-kind widget at zoom 1, the way someone reading the desk sees it.
      const n: Record<string, number> = {}
      for (const w of report.detail as { id: string; kind: string }[]) {
        if (!DETAIL_KINDS.includes(w.kind)) continue
        n[w.kind] = (n[w.kind] ?? 0) + 1
        // Deterministic camera: zoom 1 with the widget's top-left 80px inside the
        // canvas, right of the sidebar (zoomToWidget's centring animates and can be
        // caught mid-pan).
        await window.evaluate((id) => {
          const s = (window as any).__fbWidgets.getState()
          const wd = s.widgets.find((x: any) => x.id === id)
          s.setZoom(1)
          s.setPan(420 - wd.x, 80 - wd.y) // clear of the sidebar
        }, w.id)
        await window.waitForTimeout(w.kind === 'webview' ? 2500 : 900)
        await window.evaluate(() => (window as any).__fbWidgets.getState().setActive?.(null)).catch(() => {})
        await window
          .locator(`[data-widget-id="${w.id}"]`)
          .screenshot({ path: join(OUT, `${slug}--${w.kind}-${n[w.kind]}.png`) })
          .catch(() => {})
      }
    }
    writeFileSync(join(OUT, '_webview-failures.json'), JSON.stringify(await app.evaluate(() => (globalThis as any).__wvFail), null, 2))
  } finally {
    await l.dispose()
  }
})
