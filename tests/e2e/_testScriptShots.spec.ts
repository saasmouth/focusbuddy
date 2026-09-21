// Capture for the 3.1 test script (NOT a regression test).
//
// Every screenshot is the real running build, and every click marker is the
// REAL bounding box of the element a tester is told to click, read back from
// the page. Nothing is positioned by eye, so a callout cannot drift away from
// the control it points at when the layout changes.

import { test } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'
import { resolve } from 'path'
import { existsSync, mkdirSync, writeFileSync } from 'fs'

test.setTimeout(300_000)
const OUT = resolve(__dirname, '../../test-results/testscript')
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })

let launched: LaunchedApp | null = null
test.afterEach(async () => { if (launched) { await launched.dispose(); launched = null } })

interface Marker { n: number; label: string }
const manifest: Record<string, { markers: Marker[]; detail?: boolean }> = {}

async function dismissChrome(window: LaunchedApp['window']): Promise<void> {
  const later = window.getByRole('button', { name: 'Later' })
  if (await later.isVisible({ timeout: 1500 }).catch(() => false)) {
    await later.click().catch(() => {})
    await window.waitForTimeout(200)
  }
  const wn = window.locator('[data-testid="whats-new-close"]')
  if (await wn.isVisible({ timeout: 800 }).catch(() => false)) {
    await wn.click().catch(() => {})
    await window.waitForTimeout(200)
  }
}

/**
 * Draw the callouts INTO the page, then shoot it.
 *
 * The first version measured each control and positioned markers over the
 * image afterwards. That meant reconciling CSS pixels, devicePixelRatio and a
 * zoom factor across two coordinate spaces, and it put markers confidently on
 * the wrong controls twice. Drawing them in the page removes the arithmetic
 * altogether: the ring is a sibling of the thing it points at, so it cannot be
 * anywhere else.
 */
async function shoot(
  window: LaunchedApp['window'],
  name: string,
  targets: { sel: string; label: string }[],
  // When the action lives in a small strip of a large window — the run dock is
  // 5% of the page — the full shot cannot show anyone where to click. A second
  // crop of just that region goes beside it.
  detailSel?: string
): Promise<void> {
  const labels = await window.evaluate((ts) => {
    const host = document.createElement('div')
    host.id = '__shotmarks'
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none'
    document.body.appendChild(host)
    const out: { n: number; label: string }[] = []
    ts.forEach((t, i) => {
      const el = document.querySelector(t.sel)
      if (!el) return
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) return
      const n = i + 1
      const ring = document.createElement('div')
      ring.style.cssText = `position:absolute;left:${r.left - 3}px;top:${r.top - 3}px;width:${r.width + 6}px;height:${r.height + 6}px;border:2.5px solid #ff2d55;border-radius:6px;box-shadow:0 0 0 2px rgba(255,255,255,.75)`
      const pin = document.createElement('div')
      pin.textContent = String(n)
      pin.style.cssText = `position:absolute;left:${r.left - 13}px;top:${r.top - 13}px;width:21px;height:21px;border-radius:50%;background:#ff2d55;color:#fff;font:700 12px/21px -apple-system,sans-serif;text-align:center;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.3)`
      host.append(ring, pin)
      out.push({ n, label: t.label })
    })
    return out
  }, targets)

  await window.screenshot({ path: resolve(OUT, `${name}.png`) })
  // Screenshot the ELEMENT, not a clip rectangle I worked out myself. Playwright
  // resolves its position, scroll and device scale; my own clip maths put the
  // crop half a dock too low.
  let hasDetail = false
  if (detailSel) {
    const el = window.locator(detailSel).first()
    if (await el.isVisible().catch(() => false)) {
      await el.screenshot({ path: resolve(OUT, `${name}-detail.png`) }).then(
        () => { hasDetail = true },
        () => { hasDetail = false }
      )
    }
  }
  await window.evaluate(() => document.getElementById('__shotmarks')?.remove())
  manifest[name] = { markers: labels, detail: hasDetail }
  writeFileSync(resolve(OUT, 'markers.json'), JSON.stringify(manifest, null, 2))
}

async function seed(window: LaunchedApp['window']): Promise<{ desk: string; doc: string }> {
  return window.evaluate(async () => {
    const w = window as any
    const d = await w.__fbNodes.getState().create({ kind: 'task', title: 'Q4 launch', parentId: null })
    await w.__fbNodes.getState().create({ kind: 'task', title: 'Supplier sourcing', parentId: null })
    await w.__fbNodes.getState().refresh()
    const doc = await w.api.documents.create({ docType: 'sheet', title: 'Budget tracker' })
    return { desk: d.id as string, doc: doc.id as string }
  })
}

test('capture', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await dismissChrome(window)
  const { desk, doc } = await seed(window)

  // 1 — Office home: the Browser is an app
  await window.evaluate(() => (window as any).__fbView.getState().goOffice())
  await window.waitForTimeout(2500)
  await shoot(window, '01-office-home', [
    { sel: '[data-testid="office-app-browser"]', label: 'Browser tile' },
    { sel: '[data-testid="office-sideapp-browser"]', label: 'Browser under APPS' }
  ])

  // 2 — The browser itself
  await window.locator('[data-testid="office-app-browser"]').click()
  await window.waitForTimeout(6000)
  await shoot(window, '02-office-browser', [
    { sel: '[data-testid="office-browser-agent"]', label: 'Ask Plexii' },
    { sel: '[data-testid="office-browser-send"]', label: 'Send to desk' },
    { sel: '[data-testid="open-tray"]', label: 'Open tray' }
  ])

  // 3 — Ask Plexii, with the quick actions
  await window.locator('[data-testid="office-browser-agent"]').click()
  await window.waitForTimeout(900)
  await shoot(window, '03-ask-plexii', [
    { sel: '[data-testid="agent-ask-input"]', label: 'Type a task' },
    { sel: '[data-testid="agent-quick-summarise"]', label: 'Summarise' },
    { sel: '[data-testid="agent-quick-images"]', label: 'Images' },
    { sel: '[data-testid="agent-quick-extract"]', label: 'Extract data' }
  ], '[data-testid="agent-ask-dock"]')

  // 4 — A run in flight: steer it
  await window.evaluate(() => {
    const w = window as any
    w.__fbBrowserAgent.setState({ runs: { r1: {
      runId: 'r1', task: 'find UK soup suppliers and put them in a table', outcome: 'running',
      summary: '', pendingConsentHost: null,
      events: [{ kind: 'acted', narration: 'Reading the supplier list on this page', action: { kind: 'read_page' }, ok: true }],
      cost: { costMicros: 4200, inputTokens: 8100, outputTokens: 420 },
      findings: null, delivery: { state: 'idle', message: '' } } } })
    w.__fbWebPanel.getState().setActiveRun('r1')
  })
  await window.waitForTimeout(900)
  await window.locator('[data-testid="agent-run-steer-input"]').fill('only UK suppliers, skip the blog posts')
  await window.waitForTimeout(400)
  await shoot(window, '04-steer', [
    { sel: '[data-testid="agent-run-steer-input"]', label: 'Guidance box' },
    { sel: '[data-testid="agent-run-steer-send"]', label: 'Send' },
    { sel: '[data-testid="agent-run-stop"]', label: 'Stop' }
  ], '[data-testid="agent-run-dock"]')

  // 5 — A finished run: choose the desk
  await window.evaluate(() => {
    const w = window as any
    const records = Array.from({ length: 12 }, (_, i) => ({
      name: `Supplier ${i + 1}`, rating: (4.9 - i * 0.05).toFixed(2), lead_time: `${1 + (i % 5)} days`
    }))
    w.__fbBrowserAgent.setState({ runs: { r1: {
      runId: 'r1', task: 'find UK soup suppliers and put them in a table', outcome: 'done',
      summary: 'Found 12 suppliers across 6 sites.', pendingConsentHost: null, events: [],
      cost: { costMicros: 9100, inputTokens: 21000, outputTokens: 900 },
      findings: { fields: ['name','rating','lead_time'], records, answer: 'Supplier 1 rates highest at 4.9.' },
      delivery: { state: 'idle', message: '' } } } })
    w.__fbWebPanel.getState().setActiveRun('r1')
  })
  await window.waitForTimeout(800)
  await window.locator('[data-testid="agent-run-use-findings"]').click()
  await window.waitForTimeout(600)
  await shoot(window, '05-put-on-desk', [
    { sel: '[data-testid="agent-run-use-findings"]', label: 'Put on a desk' },
    { sel: `[data-testid="agent-run-desk-${desk}"]`, label: 'Pick the desk' }
  ], '[data-testid="agent-run-dock"]')

  // 6 — The result on the desk
  await window.locator(`[data-testid="agent-run-desk-${desk}"]`).click()
  await window.waitForTimeout(3500)
  await window.evaluate((id) => (window as any).__fbView.getState().goTask(id), desk)
  await window.waitForTimeout(3000)
  await shoot(window, '06-result-on-desk', [])

  // 7 — The tray, with several contexts open
  await window.evaluate(() => (window as any).__fbView.getState().goPlexiBrain('decisions'))
  await window.waitForTimeout(500)
  await window.evaluate(() => (window as any).__fbView.getState().goPlexiDesk('plans'))
  await window.waitForTimeout(500)
  await window.evaluate(() => (window as any).__fbView.getState().goOffice('mail'))
  await window.waitForTimeout(1800)
  await shoot(window, '07-tray', [
    { sel: '[data-testid="open-tray"]', label: 'Everything you have open' }
  ], '[data-testid="open-tray"]')

  // 8 — Documents in Office: drag or right-click to file
  await window.evaluate(() => (window as any).__fbView.getState().goOffice())
  await window.waitForTimeout(2500)
  // Point at the actual gesture: the document row you drag, and the desk tab
  // you drop it on. App tiles have nothing to do with filing a document.
  await shoot(window, '08-office-docs', [
    { sel: `[data-testid="office-recent-row-${doc}"]`, label: 'Drag this document row…' },
    { sel: `[data-testid="tray-item-task:${desk}"]`, label: '…onto a desk tab here' }
  ])

  // 9 — A document open: the panel starts out of the way
  // A DOC, not a sheet: the outline/comments panel belongs to the document
  // editor. Spreadsheets have their own chrome and no such panel.
  await window.evaluate(async () => {
    const w = window as any
    const doc = await w.api.documents.create({ docType: 'doc', title: 'Launch notes' })
    w.__fbView.getState().goOffice(undefined, doc.id)
  })
  await window.waitForTimeout(3000)
  await shoot(window, '09-doc-panel', [
    { sel: '[data-testid="doc-side-panel-expand"]', label: 'Bring the panel back' },
    { sel: '[data-testid="doc-outline-toggle"]', label: 'Outline' }
  ], '[data-testid="doc-outline-toggle"]')
})
